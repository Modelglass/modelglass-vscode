/**
 * SCO-232 — tests for provider-key storage. Uses a plain in-memory
 * SecretStore fake (structurally compatible with vscode.SecretStorage, but
 * no vscode import needed) rather than a real Extension Host — same
 * approach the rest of this repo's fixture-based tests take. Imports from
 * ./provider-keys-lib.ts (the vscode-free half) rather than
 * ./provider-keys.ts, which imports `vscode` for its prompting UI and can't
 * resolve outside the Extension Host.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_PROVIDERS,
  addProviderKey,
  clearProviderKey,
  getConfiguredProvider,
  getConfiguredProviders,
  getProviderKey,
  setProviderKeyValue,
  type SecretStore,
} from "./provider-keys-lib.js";

function makeSecretStore(): SecretStore {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key);
    },
    async store(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("provider-keys", () => {
  test("stores and retrieves a key for a provider", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "openai", "sk-test-123");
    assert.equal(await getProviderKey(secrets, "openai"), "sk-test-123");
  });

  test("trims whitespace when storing", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "anthropic", "  sk-ant-abc  ");
    assert.equal(await getProviderKey(secrets, "anthropic"), "sk-ant-abc");
  });

  test("getConfiguredProvider returns undefined when nothing is set", async () => {
    const secrets = makeSecretStore();
    assert.equal(await getConfiguredProvider(secrets), undefined);
  });

  test("getConfiguredProvider finds the one configured provider", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "deepseek", "ds-key");
    const configured = await getConfiguredProvider(secrets);
    assert.deepEqual(configured, { provider: "deepseek", apiKey: "ds-key" });
  });

  test("setting a new provider's key clears every other provider's stored key (single-key invariant)", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "openai", "openai-key");
    const { replaced } = await setProviderKeyValue(secrets, "groq", "groq-key");

    assert.equal(replaced, "openai");
    assert.equal(await getProviderKey(secrets, "openai"), undefined);
    assert.equal(await getProviderKey(secrets, "groq"), "groq-key");

    // Confirm no other provider slot was ever touched.
    for (const provider of SUPPORTED_PROVIDERS) {
      if (provider === "groq") continue;
      assert.equal(await getProviderKey(secrets, provider), undefined);
    }
  });

  test("re-storing the same provider's key does not report a replacement", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "mistral", "first-key");
    const { replaced } = await setProviderKeyValue(secrets, "mistral", "rotated-key");
    assert.equal(replaced, null);
    assert.equal(await getProviderKey(secrets, "mistral"), "rotated-key");
  });

  test("clearProviderKey removes the stored key", async () => {
    const secrets = makeSecretStore();
    await setProviderKeyValue(secrets, "xai", "xai-key");
    await clearProviderKey(secrets, "xai");
    assert.equal(await getProviderKey(secrets, "xai"), undefined);
    assert.equal(await getConfiguredProvider(secrets), undefined);
  });
});

// ---------------------------------------------------------------------------
// SCO-233 (Pro) — multi-key storage. addProviderKey/getConfiguredProviders are
// purely additive; every test above (Starter's setProviderKeyValue exclusivity
// invariant) is unmodified and still passing, unaffected by anything below.
// ---------------------------------------------------------------------------

describe("provider-keys — SCO-233 multi-key (Pro)", () => {
  test("getConfiguredProviders returns an empty array when nothing is configured", async () => {
    const secrets = makeSecretStore();
    assert.deepEqual(await getConfiguredProviders(secrets), []);
  });

  test("addProviderKey stores a key without touching any other provider's slot", async () => {
    const secrets = makeSecretStore();
    await addProviderKey(secrets, "openai", "openai-key");
    await addProviderKey(secrets, "anthropic", "anthropic-key");
    await addProviderKey(secrets, "groq", "groq-key");

    assert.equal(await getProviderKey(secrets, "openai"), "openai-key");
    assert.equal(await getProviderKey(secrets, "anthropic"), "anthropic-key");
    assert.equal(await getProviderKey(secrets, "groq"), "groq-key");
  });

  test("getConfiguredProviders reports every configured key, multiple at once", async () => {
    const secrets = makeSecretStore();
    await addProviderKey(secrets, "openai", "openai-key");
    await addProviderKey(secrets, "anthropic", "anthropic-key");

    const configured = await getConfiguredProviders(secrets);
    assert.equal(configured.length, 2);
    assert.deepEqual(
      new Set(configured.map((c) => c.provider)),
      new Set(["openai", "anthropic"]),
    );
  });

  test("addProviderKey trims whitespace, same as setProviderKeyValue", async () => {
    const secrets = makeSecretStore();
    await addProviderKey(secrets, "mistral", "  sk-mistral  ");
    assert.equal(await getProviderKey(secrets, "mistral"), "sk-mistral");
  });

  test("addProviderKey re-called for the same provider rotates that provider's own key only", async () => {
    const secrets = makeSecretStore();
    await addProviderKey(secrets, "openai", "first-key");
    await addProviderKey(secrets, "anthropic", "anthropic-key");
    await addProviderKey(secrets, "openai", "rotated-key");

    assert.equal(await getProviderKey(secrets, "openai"), "rotated-key");
    assert.equal(await getProviderKey(secrets, "anthropic"), "anthropic-key"); // untouched
  });

  test("getConfiguredProvider (singular) still returns just the first when multiple are configured", async () => {
    const secrets = makeSecretStore();
    // SUPPORTED_PROVIDERS iteration order: openai comes before groq.
    await addProviderKey(secrets, "groq", "groq-key");
    await addProviderKey(secrets, "openai", "openai-key");

    const first = await getConfiguredProvider(secrets);
    assert.equal(first?.provider, "openai");
  });

  test("mixing addProviderKey then setProviderKeyValue: the exclusive write still clears every other slot", async () => {
    const secrets = makeSecretStore();
    await addProviderKey(secrets, "openai", "openai-key");
    await addProviderKey(secrets, "anthropic", "anthropic-key");
    await addProviderKey(secrets, "groq", "groq-key");

    // Starter's exclusive path, even after Pro-style multi-add, still
    // enforces single-key down to whatever provider it targets.
    await setProviderKeyValue(secrets, "mistral", "mistral-key");

    assert.deepEqual(await getConfiguredProviders(secrets), [{ provider: "mistral", apiKey: "mistral-key" }]);
  });
});
