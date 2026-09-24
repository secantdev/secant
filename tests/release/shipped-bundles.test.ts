import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  SHIPPED_BUNDLE_FOLDERS,
  buildShippedBundles,
  readLock,
} from "../../scripts/shipped-bundles.js";
import { sha256 } from "../helpers/sha256.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";

// The Shipped Bundle allow-list builds to exactly the locked bytes (ADR 0029
// Versioning): the same check `scripts/build.ts` runs before embedding, here so
// every OS's `bun test` reports a digest drift with the lock remedy. The
// compiled-binary side (the embedded bytes) is the package smoke's.

const repoRoot = resolve(import.meta.dirname, "..", "..");

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    .sort();
}

test("the allow-list builds to exactly the locked identity, version and digest", () => {
  const out = makeTempDir("secant-shipped-");
  const shipped = buildShippedBundles(out);

  assert.deepEqual(
    shipped.map(({ id, version, digest }) => ({ id, version, digest })),
    readLock(),
  );
  for (const bundle of shipped) {
    assert.equal(sha256(bundle.file), bundle.digest);
  }
  assert.deepEqual(
    readdirSync(out),
    readLock().map(({ id, version }) => `${id}-${version}.wfb`),
  );
});

test("the Matt Bundle carries every authored file, all eight skill folders, and nothing else", () => {
  assert.deepEqual(SHIPPED_BUNDLE_FOLDERS, ["bundles/matt-front-spec"]);
  const folder = join(repoRoot, "bundles", "matt-front-spec");
  const [matt] = buildShippedBundles(makeTempDir("secant-shipped-"));
  assert.ok(matt);

  const entries = readArchiveEntries(readFileSync(matt.file));
  // manifest.json is re-serialized as the packaged manifest; every other entry
  // is the authored file's exact bytes.
  assert.deepEqual(
    entries.map((entry) => entry.path),
    filesUnder(folder),
  );
  for (const entry of entries) {
    if (entry.path === "manifest.json") continue;
    assert.ok(entry.data.equals(readFileSync(join(folder, entry.path))));
  }
  assert.deepEqual(
    [
      ...new Set(
        entries
          .map((entry) => entry.path.split("/"))
          .filter((parts) => parts[0] === "skills")
          .map((parts) => parts[1]),
      ),
    ].sort(),
    [
      "code-review",
      "codebase-design",
      "grill-me",
      "grilling",
      "implement",
      "tdd",
      "to-spec",
      "to-tickets",
    ],
  );
});

test("a digest that differs from the lock fails the build with the version-bump remedy", () => {
  const [locked] = readLock();
  assert.ok(locked);
  assert.throws(
    () =>
      buildShippedBundles(makeTempDir("secant-shipped-"), [
        { ...locked, digest: "0".repeat(64) },
      ]),
    /bump the manifest version and update bundles\/builtin\.lock\.json/,
  );
});

test("a lock entry with no allow-listed folder fails the build", () => {
  assert.throws(
    () =>
      buildShippedBundles(makeTempDir("secant-shipped-"), [
        ...readLock(),
        { id: "dev.secant.gone", version: "1.0.0", digest: "0".repeat(64) },
      ]),
    /dev\.secant\.gone@1\.0\.0 is locked but not built/,
  );
});
