import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/application/application.js";
import {
  buildBundle,
  DEFAULT_BUDGETS,
  writeZip,
  type Budgets,
} from "../../src/bundle/bundle.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";

// The Bundle-management contract end to end, against a temporary home with real
// bytes built from the Proof Bundle (issue #53 acceptance).

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);

async function harness(t: TestContext, budgets: Budgets = DEFAULT_BUDGETS) {
  const home = makeTempDir("secant-install-home-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  const launchWorkspacePath = realpathSync.native(
    makeTempDir("secant-install-ws-"),
  );
  const { bundleManagement } = createApplication({
    catalog,
    launchWorkspacePath,
    bundleBudgets: budgets,
  });
  return { catalog, bundle: bundleManagement };
}

function proofBytes(): Uint8Array {
  const built = buildBundle(proofBundle);
  assert.ok(built.ok);
  return built.built.bytes;
}

function writeArchive(bytes: Uint8Array): string {
  const path = join(makeTempDir("secant-install-file-"), "bundle.wfb");
  writeFileSync(path, bytes);
  return path;
}

function authoringFolder(manifest: unknown): string {
  const dir = makeTempDir("secant-authoring-");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("a manifest with two invalid fields reports both as field violations in order", async (t) => {
  const h = await harness(t);
  const result = h.bundle.build(
    authoringFolder({
      formatVersion: 1,
      bundle: {
        id: "Not_Reverse_Domain",
        version: "1.0",
        name: "Sample",
        description: "A sample.",
      },
      inputs: {},
      assets: [],
      routing: [],
    }),
    { noInstall: false },
  );
  assert.ok(!result.ok);
  assert.deepEqual(
    (result.problem.fieldViolations ?? []).map((v) => v.field),
    ["bundle.id", "bundle.version"],
  );
  assert.equal(h.catalog.countInstalledBundles(), 0);
});

test("building the Proof Bundle installs it and the count reads back one", async (t) => {
  const h = await harness(t);
  const result = h.bundle.build(proofBundle, { noInstall: false });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.report.identity, {
    id: "dev.secant.test-repair",
    version: "1.0.0",
  });
  assert.equal(result.report.installed?.status, "installed");
  assert.equal(h.catalog.countInstalledBundles(), 1);
});

test("installing the exact file written by --output is already installed", async (t) => {
  const h = await harness(t);
  const file = writeArchive(proofBytes());

  const first = h.bundle.install(file);
  assert.ok(first.ok);
  assert.equal(first.report.installed?.status, "installed");

  const again = h.bundle.install(file);
  assert.ok(again.ok);
  assert.equal(again.report.installed?.status, "already-installed");
  assert.equal(h.catalog.countInstalledBundles(), 1);
});

test("a byte-different archive of the same identity is an identity collision", async (t) => {
  const h = await harness(t);
  assert.ok(h.bundle.build(proofBundle, { noInstall: false }).ok);

  // Same manifest (same identity) but an extra entry, so the bytes and digest
  // differ while the identity does not.
  const different = writeZip([
    ...readArchiveEntries(proofBytes()),
    { path: "extra.txt", data: Buffer.from("different") },
  ]);
  const collision = h.bundle.install(writeArchive(different));
  assert.ok(!collision.ok);
  assert.equal(collision.problem.code, "bundle-identity-collision");
  // Neither the count nor the Entry changed.
  assert.equal(h.catalog.countInstalledBundles(), 1);
});

test("a rejected archive shape produces a distinct Problem before any write", async (t) => {
  const h = await harness(t);
  const traversing = writeZip([{ path: "../evil", data: Buffer.from("x") }]);
  const result = h.bundle.install(writeArchive(traversing));
  assert.ok(!result.ok);
  assert.equal(result.problem.code, "unsafe-path");
  assert.equal(h.catalog.countInstalledBundles(), 0);
});

test("an exceeded budget rejects before install", async (t) => {
  const h = await harness(t, { ...DEFAULT_BUDGETS, maxInputBytes: 1 });
  const result = h.bundle.install(writeArchive(proofBytes()));
  assert.ok(!result.ok);
  assert.equal(result.problem.code, "archive-too-large");
  assert.equal(h.catalog.countInstalledBundles(), 0);
});

// --- the install-time Composition check (#100, A41) --------------------------

const commandGate = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "command-gate",
);

test("installing a shape-valid archive that does not compose is refused with the build-time finding code", async (t) => {
  const h = await harness(t);
  const packaged = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.non-composing",
      version: "1.0.0",
      name: "Non Composing",
      description: "Loops on an unbound Verdict.",
    },
    requires: { engine: ">=0.1.0" },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing: [
      {
        repeat: {
          until: "never-bound",
          reviewCheckpoint: { interval: 1, message: "continue?" },
          steps: [
            {
              id: "a",
              kind: "command",
              produces: [{ name: "v", type: "verdict" }],
              command: { executable: "bun", arguments: [] },
            },
          ],
        },
      },
    ],
  };
  const bytes = writeZip([
    { path: "manifest.json", data: Buffer.from(JSON.stringify(packaged)) },
  ]);
  const result = h.bundle.install(writeArchive(bytes));
  assert.ok(!result.ok);
  assert.equal(result.problem.code, "composition-check-failed");
  assert.match(
    result.problem.fieldViolations?.[0]?.explanation ?? "",
    /\[verdict-unbound-before-entry\]/,
  );
  assert.equal(h.catalog.countInstalledBundles(), 0);
});

test("the Command-only gate Bundle still installs under the Composition check", async (t) => {
  const h = await harness(t);
  const result = h.bundle.build(commandGate, { noInstall: false });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.report.installed?.status, "installed");
  const again = h.bundle.install(
    writeArchive(
      (() => {
        const built = buildBundle(commandGate);
        assert.ok(built.ok);
        return built.built.bytes;
      })(),
    ),
  );
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.report.installed?.status, "already-installed");
});
