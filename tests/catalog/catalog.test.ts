import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  openCatalog,
  type BundleInstall,
  type BundleOrigin,
} from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function install(
  id: string,
  version: string,
  bytes: Uint8Array,
  origin: BundleOrigin = { kind: "local-file", path: `/tmp/${id}.wfb` },
  digest = digestOf(bytes),
): BundleInstall {
  return {
    identity: { id, version },
    digest,
    bytes,
    origin,
    installedAt: new Date("2026-09-11T12:00:00.000Z"),
  };
}

test("an approval is recorded and read back over a temporary home", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  assert.equal(catalog.getWorkspaceApproval("/tmp/ws"), undefined);
  const record = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-09-09T10:00:00.000Z"),
  );
  assert.deepEqual(record, {
    path: "/tmp/ws",
    approvedAt: "2026-09-09T10:00:00.000Z",
  });
  assert.deepEqual(catalog.getWorkspaceApproval("/tmp/ws"), record);
});

test("re-approving keeps the first time and writes no second record", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  const first = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const second = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-02-02T00:00:00.000Z"),
  );
  assert.deepEqual(second, first);
});

test("approvals survive reopening the same home", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const first = await openCatalog(home);
  first.approveWorkspace("/tmp/ws", new Date("2026-03-03T00:00:00.000Z"));
  first.close();

  const second = await openCatalog(home);
  t.after(() => second.close());
  assert.equal(
    second.getWorkspaceApproval("/tmp/ws")?.approvedAt,
    "2026-03-03T00:00:00.000Z",
  );
});

test("installing a Bundle stores its bytes and records the Entry", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = catalog.installBundle(
    install("io.example.a", "1.0.0", bytes, {
      kind: "local-build",
      folder: "/authoring/a",
    }),
  );
  assert.equal(result.outcome, "installed");
  assert.ok(result.outcome === "installed");
  assert.deepEqual(result.entry.origin, {
    kind: "local-build",
    folder: "/authoring/a",
  });
  assert.equal(result.entry.installationGeneration, 1);
  assert.equal(catalog.countInstalledBundles(), 1);

  const stored = join(home, "bundles", `${digestOf(bytes)}.wfb`);
  assert.ok(existsSync(stored));
  assert.equal(Buffer.compare(readFileSync(stored), Buffer.from(bytes)), 0);
});

test("re-installing an equal digest is already-installed and changes nothing", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  const bytes = new Uint8Array([9, 9, 9]);
  const first = catalog.installBundle(install("io.example.a", "1.0.0", bytes));
  const second = catalog.installBundle(install("io.example.a", "1.0.0", bytes));
  assert.equal(first.outcome, "installed");
  assert.equal(second.outcome, "already-installed");
  assert.ok(second.outcome === "already-installed");
  assert.equal(second.entry.installationGeneration, 1);
  assert.equal(catalog.countInstalledBundles(), 1);
});

test("a byte-different Bundle of the same identity is an identity collision", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());

  catalog.installBundle(install("io.example.a", "1.0.0", new Uint8Array([1])));
  const collision = catalog.installBundle(
    install("io.example.a", "1.0.0", new Uint8Array([2])),
  );
  assert.equal(collision.outcome, "identity-collision");
  assert.ok(collision.outcome === "identity-collision");
  assert.equal(collision.existing.digest, digestOf(new Uint8Array([1])));
  assert.equal(catalog.countInstalledBundles(), 1);
  // The colliding bytes were never stored.
  assert.deepEqual(readdirSync(join(home, "bundles")), [
    `${digestOf(new Uint8Array([1]))}.wfb`,
  ]);
});

test("a verify failure after staging leaves no store bytes and no Entry", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());

  const bytes = new Uint8Array([5, 5, 5]);
  // A digest that does not match the bytes is a caller-contract violation the
  // atomic install detects when it verifies the staged copy.
  assert.throws(() =>
    catalog.installBundle(
      install("io.example.a", "1.0.0", bytes, undefined, "0".repeat(64)),
    ),
  );
  assert.equal(catalog.countInstalledBundles(), 0);
  const bundlesDir = join(home, "bundles");
  assert.ok(!existsSync(bundlesDir) || readdirSync(bundlesDir).length === 0);
});

test("different identities both install and persist across reopening", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const first = await openCatalog(home);
  const a = first.installBundle(
    install("io.example.a", "1.0.0", new Uint8Array([1])),
  );
  const b = first.installBundle(
    install("io.example.b", "1.0.0", new Uint8Array([2])),
  );
  assert.equal(a.outcome, "installed");
  assert.equal(b.outcome, "installed");
  assert.ok(a.outcome === "installed" && b.outcome === "installed");
  assert.equal(a.entry.installationGeneration, 1);
  assert.equal(b.entry.installationGeneration, 2);
  first.close();

  const second = await openCatalog(home);
  t.after(() => second.close());
  assert.equal(second.countInstalledBundles(), 2);
  // A second connection over the same home commits without corruption; the
  // first install stays and a third distinct identity lands beside it.
  const c = second.installBundle(
    install("io.example.c", "1.0.0", new Uint8Array([3])),
  );
  assert.equal(c.outcome, "installed");
  assert.equal(second.countInstalledBundles(), 3);
});
