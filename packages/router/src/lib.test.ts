/**
 * Vendored from modelglass-router-examples/cost-aware-vscode-router/src/lib.test.ts
 * (SCO-211) — tests for the exact functions vendored into ./lib.ts. The
 * deviationType() describe block was dropped along with that function (not
 * vendored — belongs to the CLI's report command, out of scope here).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type ModelEntry,
  type NormalisedModel,
  type Task,
  type Tier,
  codingQualityBar,
  headlinePrice,
  normalise,
  selectCodingModel,
  selectWritingModel,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<NormalisedModel> & { name: string }): NormalisedModel {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    provider: "test-provider",
    qualityTier: "premium",
    codingRating: "strong",
    instrRating: null,
    sweBenchVerified: null,
    sweBenchSource: "",
    hasSweBenchPro: false,
    inputPricePerM: null,
    outputPricePerM: null,
    ...overrides,
  };
}

const O4_MINI = makeModel({
  name: "o4-mini",
  sweBenchVerified: 68.1,
  sweBenchSource: "openai.com, vendor",
  inputPricePerM: 1.1,
  outputPricePerM: 4.4,
});
const GEMINI_2_5_PRO = makeModel({
  name: "Gemini 2.5 Pro",
  sweBenchVerified: 63.8,
  sweBenchSource: "deepmind.google, vendor",
  inputPricePerM: 1.25,
  outputPricePerM: 10,
});
const NO_SCORE_MODEL = makeModel({ name: "Mistral Large 3", inputPricePerM: 0.5 });
const PRO_ONLY_MODEL = makeModel({
  name: "Claude Sonnet 5",
  hasSweBenchPro: true,
  inputPricePerM: 3,
});

const POOL = [O4_MINI, GEMINI_2_5_PRO, NO_SCORE_MODEL, PRO_ONLY_MODEL];

// ---------------------------------------------------------------------------
// selectCodingModel — no threshold (backward-compatible default)
// ---------------------------------------------------------------------------

describe("selectCodingModel with no threshold", () => {
  test("picks the cheapest confirmed-score candidate, unaffected by qualifying filter", () => {
    const { selected, qualifying } = selectCodingModel(POOL);
    assert.equal(selected, O4_MINI);
    assert.equal(qualifying.length, 2);
  });

  test("excludes no-score and pro-only models with their existing reasons", () => {
    const { excluded } = selectCodingModel(POOL);
    const reasons = excluded.map((e) => e.model.name);
    assert.ok(reasons.includes("Mistral Large 3"));
    assert.ok(reasons.includes("Claude Sonnet 5"));
  });
});

// ---------------------------------------------------------------------------
// selectCodingModel — with a quality-bar threshold
// ---------------------------------------------------------------------------

describe("selectCodingModel with minSweBenchVerified threshold", () => {
  test("a threshold between the two real scores excludes the weaker one, keeps the pick unchanged", () => {
    const { selected, qualifying, excluded } = selectCodingModel(POOL, 65);
    assert.equal(selected, O4_MINI);
    assert.equal(qualifying.length, 1);
    assert.equal(qualifying[0], O4_MINI);
    const belowBarReason = excluded.find((e) => e.model === GEMINI_2_5_PRO);
    assert.ok(belowBarReason);
    assert.equal(
      belowBarReason!.reason,
      "SWE-bench Verified 63.8% is below the required threshold of 65%",
    );
  });

  test("a threshold above every candidate's score yields no selection at all", () => {
    const { selected, qualifying } = selectCodingModel(POOL, 90);
    assert.equal(selected, null);
    assert.equal(qualifying.length, 0);
  });

  test("a threshold at or below the weaker score doesn't exclude it — the mechanism only filters, never inflates", () => {
    const { selected, qualifying } = selectCodingModel(POOL, 63.8);
    assert.equal(selected, O4_MINI);
    assert.equal(qualifying.length, 2);
  });

  test("a cheaper-but-below-bar model does NOT win over a pricier-but-qualifying one", () => {
    const cheapWeak = makeModel({ name: "Cheap Weak", sweBenchVerified: 40, inputPricePerM: 0.1 });
    const pricyStrong = makeModel({ name: "Pricy Strong", sweBenchVerified: 80, inputPricePerM: 9 });
    const { selected } = selectCodingModel([cheapWeak, pricyStrong], 65);
    assert.equal(selected, pricyStrong);
  });
});

// ---------------------------------------------------------------------------
// codingQualityBar — derives the task-level threshold
// ---------------------------------------------------------------------------

function makeTask(subtasks: Task["subtasks"]): Task {
  return { description: "test task", subtasks };
}

describe("codingQualityBar", () => {
  test("returns null when no subtask sets a threshold", () => {
    const task = makeTask([{ description: "code it", tag: "coding" }]);
    assert.equal(codingQualityBar(task), null);
  });

  test("returns the single threshold when only one coding subtask sets one", () => {
    const task = makeTask([
      { description: "code it", tag: "coding", minSweBenchVerified: 65 },
      { description: "write it", tag: "writing" },
    ]);
    assert.equal(codingQualityBar(task), 65);
  });

  test("returns the strictest (highest) threshold across multiple coding subtasks", () => {
    const task = makeTask([
      { description: "easy part", tag: "coding", minSweBenchVerified: 50 },
      { description: "hard part", tag: "coding", minSweBenchVerified: 75 },
    ]);
    assert.equal(codingQualityBar(task), 75);
  });

  test("ignores a threshold set on a non-coding subtask", () => {
    const task = makeTask([
      { description: "code it", tag: "coding" },
      { description: "write it", tag: "writing", minSweBenchVerified: 90 },
    ]);
    assert.equal(codingQualityBar(task), null);
  });
});

// ---------------------------------------------------------------------------
// selectWritingModel — regression guard
// ---------------------------------------------------------------------------

describe("selectWritingModel", () => {
  test("still picks cheapest strong|good instruction-following candidate, untouched by the coding quality bar", () => {
    const writer = makeModel({ name: "Llama 4 Scout", instrRating: "strong", inputPricePerM: 0.1 });
    const selected = selectWritingModel([...POOL, writer]);
    assert.equal(selected, writer);
  });
});

// ---------------------------------------------------------------------------
// normalise — host attribution
// ---------------------------------------------------------------------------

function makeModelEntry(overrides: Partial<ModelEntry> & { model_id: string }): ModelEntry {
  return {
    name: overrides.model_id,
    offerings: [],
    ...overrides,
  };
}

describe("normalise", () => {
  test("SCO-633: never selects a retired offering, even when it's the cheapest", () => {
    const entry = makeModelEntry({
      model_id: "acme/multi",
      name: "Multi",
      offerings: [
        {
          slug: "multi-cheap-retired",
          provider: "cheaphost",
          quality_tier: "standard",
          model: { status: "retired" },
          tiers: [{ id: "input", pricing: [{ amount: 0.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2025-01-01" }] }],
        },
        {
          slug: "multi-live",
          provider: "livehost",
          quality_tier: "standard",
          model: { status: "ga" },
          tiers: [{ id: "input", pricing: [{ amount: 2, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }] }],
        },
      ],
    });
    const n = normalise(entry);
    assert.equal(n.provider, "livehost");
    assert.equal(n.inputPricePerM, 2);
  });

  test("carries the provider of the selected (cheapest) offering", () => {
    const entry = makeModelEntry({
      model_id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      offerings: [
        {
          slug: "claude-sonnet-5-anthropic",
          provider: "anthropic",
          quality_tier: "premium",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 3, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
      ],
    });
    const result = normalise(entry);
    assert.equal(result.provider, "anthropic");
  });

  test("picks the cheapest offering's provider when a model has multiple hosts", () => {
    const entry = makeModelEntry({
      model_id: "meta/llama-4-scout",
      name: "Llama 4 Scout",
      offerings: [
        {
          slug: "llama-4-scout-expensive-host",
          provider: "expensive-host",
          quality_tier: "fast",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 0.5, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
        {
          slug: "llama-4-scout-cheap-host",
          provider: "cheap-host",
          quality_tier: "fast",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 0.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
      ],
    });
    const result = normalise(entry);
    assert.equal(result.provider, "cheap-host");
    assert.equal(result.inputPricePerM, 0.1);
  });

  test("provider is an empty string, not undefined/throwing, when a model has zero offerings", () => {
    const entry = makeModelEntry({ model_id: "orphan/model", name: "Orphan Model" });
    const result = normalise(entry);
    assert.equal(result.provider, "");
  });
});

// ---------------------------------------------------------------------------
// SCO-646 — headline price comes from the Standard tier (the SCO-640 rule,
// same as modelglass.com.au / the MCP tools). Fixtures mirror modelglass-llm:
// gpt-5-5-pro-openai (Batch $15/$90 cheaper than Standard $30/$180) and
// inkling-thinking-machines (context-length tiers only, no `input` tier).
// ---------------------------------------------------------------------------

function priced(id: string, amount: number, unit: string, attributes?: Record<string, unknown>): Tier {
  return { id, ...(attributes ? { attributes } : {}), pricing: [{ amount, currency: "USD", unit, effective_from: "2026-01-01" }] };
}

const WITH_BATCH_TIERS = [
  priced("batch-input", 15, "per_1m_tokens_input", { processing: "batch" }),
  priced("batch-output", 90, "per_1m_tokens_output", { processing: "batch" }),
  priced("input", 30, "per_1m_tokens_input"),
  priced("output", 180, "per_1m_tokens_output"),
];
const CONTEXT_TIERS = [
  priced("input-64k", 1.87, "per_1m_tokens_input"),
  priced("output-64k", 4.68, "per_1m_tokens_output"),
  priced("input-256k", 3.74, "per_1m_tokens_input"),
  priced("output-256k", 9.36, "per_1m_tokens_output"),
];

function oneHost(model_id: string, tiers: Tier[]): ModelEntry {
  return makeModelEntry({ model_id, offerings: [{ slug: "h", provider: "host", quality_tier: "premium", tiers }] });
}

describe("normalise headline price (SCO-646)", () => {
  test("Batch cheaper than Standard: priced at Standard $30/$180", () => {
    const r = normalise(oneHost("openai/gpt-5.5-pro", WITH_BATCH_TIERS));
    assert.equal(r.inputPricePerM, 30);
    assert.equal(r.outputPricePerM, 180);
  });

  test("context-length tiers only: priced at the base rate $1.87/$4.68, not null", () => {
    const r = normalise(oneHost("thinking-machines/inkling", CONTEXT_TIERS));
    assert.equal(r.inputPricePerM, 1.87);
    assert.equal(r.outputPricePerM, 4.68);
  });

  test("headlinePrice is null when only a discounted tier has the unit", () => {
    assert.equal(headlinePrice([priced("batch-input", 15, "per_1m_tokens_input", { processing: "batch" })], "per_1m_tokens_input"), null);
  });
});
