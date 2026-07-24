/**
 * SCO-234 — tests for the Pro-tier gating logic. fetchImpl is injected (a
 * stub, never real fetch) for checkProAccess, same pattern as
 * provider-execute.test.ts / run-task.test.ts's executeFn stubs. Covers the
 * card's four required cases: a Starter user blocked from a second provider
 * key, a Starter user's routing-rules.json falling through to default
 * without erroring, a Pro user getting full access to both, and the
 * upgrade-prompt decision path (isGateSatisfied / wouldExceedSingleKeyLimit
 * are exactly what decides whether provider-keys.ts shows that prompt).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRO_GATE_TIMEOUT_MS,
  checkProAccess,
  isGateSatisfied,
  isProTierValue,
  proGatedValue,
  selectProvidersForRun,
  wouldExceedSingleKeyLimit,
  type ProGateStatus,
} from "./pro-gate-lib.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("isProTierValue", () => {
  test("pro and internal count as Pro", () => {
    assert.equal(isProTierValue("pro"), true);
    assert.equal(isProTierValue("internal"), true);
  });

  test("free, starter, and app do NOT count as Pro", () => {
    assert.equal(isProTierValue("free"), false);
    assert.equal(isProTierValue("starter"), false);
    // "app" deliberately excluded even though require-news-access.ts treats
    // it as Pro-equivalent for a different, narrower feature -- see
    // pro-gate-lib.ts's header for why that precedent doesn't generalize.
    assert.equal(isProTierValue("app"), false);
  });
});

describe("checkProAccess", () => {
  test("a valid Pro key reports isPro: true", async () => {
    const fetchStub = (async () => jsonResponse(200, { ok: true, data: { valid: true, tier: "pro" } })) as typeof fetch;
    const status = await checkProAccess("mg_pro_test", fetchStub, "https://example.test");
    assert.deepEqual(status, { isPro: true, tier: "pro" });
  });

  test("an internal key also reports isPro: true", async () => {
    const fetchStub = (async () => jsonResponse(200, { ok: true, data: { valid: true, tier: "internal" } })) as typeof fetch;
    const status = await checkProAccess("mg_internal_test", fetchStub, "https://example.test");
    assert.equal(status.isPro, true);
  });

  test("a valid Starter key reports isPro: false, reason not-pro", async () => {
    const fetchStub = (async () => jsonResponse(200, { ok: true, data: { valid: true, tier: "starter" } })) as typeof fetch;
    const status = await checkProAccess("mg_starter_test", fetchStub, "https://example.test");
    assert.deepEqual(status, { isPro: false, reason: "not-pro", tier: "starter" });
  });

  test("a valid Free key reports isPro: false, reason not-pro", async () => {
    const fetchStub = (async () => jsonResponse(200, { ok: true, data: { valid: true, tier: "free" } })) as typeof fetch;
    const status = await checkProAccess("mg_free_test", fetchStub, "https://example.test");
    assert.deepEqual(status, { isPro: false, reason: "not-pro", tier: "free" });
  });

  test("an invalid/unknown key reports reason invalid-key", async () => {
    const fetchStub = (async () => jsonResponse(200, { ok: true, data: { valid: false } })) as typeof fetch;
    const status = await checkProAccess("mg_bad_key", fetchStub, "https://example.test");
    assert.deepEqual(status, { isPro: false, reason: "invalid-key" });
  });

  test("a network failure reports reason network-error", async () => {
    const fetchStub = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const status = await checkProAccess("mg_test", fetchStub, "https://example.test");
    assert.equal(status.isPro, false);
    assert.equal((status as Extract<ProGateStatus, { reason: "network-error" }>).reason, "network-error");
  });

  test("a non-2xx HTTP response reports reason network-error", async () => {
    const fetchStub = (async () => jsonResponse(500, {})) as typeof fetch;
    const status = await checkProAccess("mg_test", fetchStub, "https://example.test");
    assert.equal(status.isPro, false);
    assert.equal((status as Extract<ProGateStatus, { reason: "network-error" }>).reason, "network-error");
  });

  test("posts the key in the request body to /v1/keys/validate", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchStub = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return jsonResponse(200, { ok: true, data: { valid: true, tier: "pro" } });
    }) as typeof fetch;

    await checkProAccess("mg_pro_abc123", fetchStub, "https://example.test");

    assert.equal(capturedUrl, "https://example.test/v1/keys/validate");
    assert.deepEqual(JSON.parse(capturedBody), { key: "mg_pro_abc123" });
  });
});

// ---------------------------------------------------------------------------
// SCO-260 quick-win #1 — checkProAccess had no bounded timeout: a hung
// Modelglass API response left it (and everything gated behind it in
// run-task.ts) waiting indefinitely instead of reaching the network-error
// fail-open path. Same hangingFetch convention as provider-execute.test.ts.
// ---------------------------------------------------------------------------
describe("checkProAccess — timeout (SCO-260 quick-win #1)", () => {
  function hangingFetch(): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
  }

  test("a hung request times out and reports reason network-error (fails open)", async () => {
    const status = await checkProAccess("mg_test", hangingFetch(), "https://example.test", 20);
    assert.equal(status.isPro, false);
    assert.equal((status as Extract<ProGateStatus, { reason: "network-error" }>).reason, "network-error");
    assert.match((status as Extract<ProGateStatus, { reason: "network-error" }>).message, /timed out/i);
    assert.equal(isGateSatisfied(status), true); // network-error fails open, per this module's documented contract
  });

  test("defaults to DEFAULT_PRO_GATE_TIMEOUT_MS when no timeoutMs is passed", async () => {
    const calls: RequestInit[] = [];
    const fetchStub = (async (_url: string, init?: RequestInit) => {
      calls.push(init!);
      return jsonResponse(200, { ok: true, data: { valid: true, tier: "pro" } });
    }) as typeof fetch;
    await checkProAccess("mg_test", fetchStub, "https://example.test");
    assert.ok(calls[0]!.signal instanceof AbortSignal);
    assert.equal(DEFAULT_PRO_GATE_TIMEOUT_MS, 15_000);
  });
});

describe("isGateSatisfied", () => {
  test("a confirmed Pro status satisfies the gate", () => {
    assert.equal(isGateSatisfied({ isPro: true, tier: "pro" }), true);
  });

  test("a confirmed non-Pro status does NOT satisfy the gate", () => {
    assert.equal(isGateSatisfied({ isPro: false, reason: "not-pro", tier: "starter" }), false);
    assert.equal(isGateSatisfied({ isPro: false, reason: "invalid-key" }), false);
  });

  test("an unverifiable status (network error / no key) fails OPEN, satisfying the gate", () => {
    assert.equal(isGateSatisfied({ isPro: false, reason: "network-error", message: "timeout" }), true);
    assert.equal(isGateSatisfied({ isPro: false, reason: "no-modelglass-key" }), true);
  });
});

describe("SCO-234 required case: Starter-tier user blocked from a second provider key", () => {
  test("wouldExceedSingleKeyLimit is true when adding a NEW provider on top of an existing one", () => {
    assert.equal(wouldExceedSingleKeyLimit(["openai"], "anthropic"), true);
  });

  test("wouldExceedSingleKeyLimit is false for a first key (nothing configured yet)", () => {
    assert.equal(wouldExceedSingleKeyLimit([], "openai"), false);
  });

  test("wouldExceedSingleKeyLimit is false when rotating an already-configured provider's own key", () => {
    assert.equal(wouldExceedSingleKeyLimit(["openai"], "openai"), false);
  });

  test("end-to-end: a confirmed Starter status blocks growing past one provider", () => {
    const starterStatus: ProGateStatus = { isPro: false, reason: "not-pro", tier: "starter" };
    const wouldGrow = wouldExceedSingleKeyLimit(["openai"], "anthropic");
    assert.equal(wouldGrow, true);
    assert.equal(isGateSatisfied(starterStatus), false); // -> provider-keys.ts shows the upgrade prompt and returns
  });
});

describe("SCO-234 required case: Starter-tier user's routing-rules.json falls through to default, no error", () => {
  test("proGatedValue discards an already-loaded rule for a confirmed non-Pro status", () => {
    const starterStatus: ProGateStatus = { isPro: false, reason: "not-pro", tier: "starter" };
    const loadedRule = { category: "autocomplete" as const, strategy: "cheapest" as const };
    const rule = proGatedValue(starterStatus, loadedRule);
    assert.equal(rule, undefined); // run-task-lib.ts's resolveCategoryRanking treats undefined as SCO-230 default -- no error path involved
  });

  test("proGatedValue passes an already-loaded rule through for a confirmed Pro status", () => {
    const proStatus: ProGateStatus = { isPro: true, tier: "pro" };
    const loadedRule = { category: "autocomplete" as const, strategy: "cheapest" as const };
    assert.deepEqual(proGatedValue(proStatus, loadedRule), loadedRule);
  });

  test("proGatedValue is a no-op (still undefined) when there was no rule to begin with, regardless of tier", () => {
    assert.equal(proGatedValue({ isPro: true, tier: "pro" }, undefined), undefined);
    assert.equal(proGatedValue({ isPro: false, reason: "not-pro", tier: "starter" }, undefined), undefined);
  });
});

describe("SCO-234 required case: Pro-tier user gets full access to both", () => {
  test("selectProvidersForRun returns every configured provider for a confirmed Pro status", () => {
    const proStatus: ProGateStatus = { isPro: true, tier: "pro" };
    const configured = [
      { provider: "openai", apiKey: "k1" },
      { provider: "anthropic", apiKey: "k2" },
      { provider: "groq", apiKey: "k3" },
    ];
    assert.deepEqual(selectProvidersForRun(configured, proStatus), configured);
  });

  test("selectProvidersForRun truncates to just the first for a confirmed non-Pro status", () => {
    const starterStatus: ProGateStatus = { isPro: false, reason: "not-pro", tier: "starter" };
    const configured = [
      { provider: "openai", apiKey: "k1" },
      { provider: "anthropic", apiKey: "k2" },
    ];
    assert.deepEqual(selectProvidersForRun(configured, starterStatus), [{ provider: "openai", apiKey: "k1" }]);
  });

  test("a Pro user is never blocked from adding a second provider key", () => {
    const proStatus: ProGateStatus = { isPro: true, tier: "pro" };
    const wouldGrow = wouldExceedSingleKeyLimit(["openai"], "anthropic");
    assert.equal(wouldGrow, true); // the action IS the multi-key case...
    assert.equal(isGateSatisfied(proStatus), true); // ...but the gate lets it through
  });
});
