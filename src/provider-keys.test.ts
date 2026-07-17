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
  clearProviderKey,
  getConfiguredProvider,
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
