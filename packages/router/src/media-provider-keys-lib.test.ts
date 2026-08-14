import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_PROVIDERS,
  clearMediaProviderKey,
  getMediaProviderKey,
  setMediaProviderKey,
  type SecretStore,
} from "./media-provider-keys-lib.js";

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

describe("media-provider-keys", () => {
  test("stores and retrieves a key for a provider", async () => {
    const secrets = makeSecretStore();
    await setMediaProviderKey(secrets, "runway", "rw-test-123");
    assert.equal(await getMediaProviderKey(secrets, "runway"), "rw-test-123");
  });

  test("trims whitespace when storing", async () => {
    const secrets = makeSecretStore();
    await setMediaProviderKey(secrets, "elevenlabs", "  el-key  ");
    assert.equal(await getMediaProviderKey(secrets, "elevenlabs"), "el-key");
  });

  // The whole point of this module (see its header): setting one media
  // provider's key must NOT touch the other's, unlike provider-keys-lib.ts's
  // exclusive single-key policy.
  test("setting a runway key does not clear an already-configured elevenlabs key", async () => {
    const secrets = makeSecretStore();
    await setMediaProviderKey(secrets, "elevenlabs", "el-key");
    await setMediaProviderKey(secrets, "runway", "rw-key");
    assert.equal(await getMediaProviderKey(secrets, "elevenlabs"), "el-key");
    assert.equal(await getMediaProviderKey(secrets, "runway"), "rw-key");
  });

  test("clearing one provider's key leaves the other untouched", async () => {
    const secrets = makeSecretStore();
    await setMediaProviderKey(secrets, "elevenlabs", "el-key");
    await setMediaProviderKey(secrets, "runway", "rw-key");
    await clearMediaProviderKey(secrets, "runway");
    assert.equal(await getMediaProviderKey(secrets, "runway"), undefined);
    assert.equal(await getMediaProviderKey(secrets, "elevenlabs"), "el-key");
  });

  test("returns undefined for an unconfigured provider", async () => {
    const secrets = makeSecretStore();
    assert.equal(await getMediaProviderKey(secrets, "runway"), undefined);
  });

  test("MEDIA_PROVIDERS covers exactly runway and elevenlabs", () => {
    assert.deepEqual([...MEDIA_PROVIDERS].sort(), ["elevenlabs", "runway"]);
  });
});
