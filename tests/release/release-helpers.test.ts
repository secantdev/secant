import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sha256File } from "../../scripts/release-helpers.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("sha256File hashes every chunk of a multi-chunk release artifact", async () => {
  const path = join(makeTempDir("secant-release-hash-"), "artifact.bin");
  writeFileSync(path, "streaming-release-hash\n".repeat(10_000));

  assert.equal(
    await sha256File(path),
    "b650ee817205825c83a09440c0e132be8ad579e0a0a4d1a1fdfaa7f0b020ee8e",
  );
});
