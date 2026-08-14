import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildResultFilename, inferExtensionFromContentType, writeResultToDisk } from "./media-file-save-lib.js";

describe("inferExtensionFromContentType", () => {
  test("recognizes known video/audio content types", () => {
    assert.equal(inferExtensionFromContentType("video/mp4", "bin"), "mp4");
    assert.equal(inferExtensionFromContentType("audio/mpeg", "bin"), "mp3");
    assert.equal(inferExtensionFromContentType("audio/mpeg; charset=binary", "bin"), "mp3");
  });

  test("falls back to the caller's default for null or unrecognized types", () => {
    assert.equal(inferExtensionFromContentType(null, "mp4"), "mp4");
    assert.equal(inferExtensionFromContentType("application/octet-stream", "mp4"), "mp4");
  });
});

describe("buildResultFilename", () => {
  test("includes category, provider, and a filesystem-safe timestamp", () => {
    const fixedDate = () => new Date("2026-08-13T12:30:00.000Z");
    const filename = buildResultFilename("video", "runway", "mp4", fixedDate);
    assert.equal(filename, "video-runway-2026-08-13T12-30-00-000Z.mp4");
    assert.ok(!filename.includes(":"), "filename must not contain characters invalid on Windows/macOS");
  });
});

describe("writeResultToDisk", () => {
  test("creates the target directory if needed and writes the bytes", async () => {
    const base = await mkdtemp(join(tmpdir(), "modelglass-media-test-"));
    try {
      const nestedDir = join(base, "nested", "dir");
      const fullPath = await writeResultToDisk(nestedDir, "out.bin", new Uint8Array([1, 2, 3]));
      assert.equal(fullPath, join(nestedDir, "out.bin"));
      const written = await readFile(fullPath);
      assert.deepEqual([...written], [1, 2, 3]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
