import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Database } from "bun:sqlite";
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

test("a home created by the pre-Drizzle release migrates in place", (t) => {
  const home = makeTempDir("secant-catalog-migration-");
  const fixture = fileURLToPath(
    new URL("../fixtures/pre-drizzle-home/catalog.db", import.meta.url),
  );
  copyFileSync(fixture, join(home, "catalog.db"));

  const catalog = openCatalog(home);
  t.after(() => catalog.close());
  assert.deepEqual(catalog.getWorkspaceApproval("/fixture/workspace"), {
    path: "/fixture/workspace",
    approvedAt: "2026-09-15T00:00:00.000Z",
  });
  assert.deepEqual(
    catalog.approveWorkspace(
      "/fixture/second",
      new Date("2026-09-15T01:00:00.000Z"),
    ),
    {
      path: "/fixture/second",
      approvedAt: "2026-09-15T01:00:00.000Z",
    },
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
  // The colliding bytes were never stored: only the first digest's bytes and
  // its derived asset tree are in the store.
  assert.deepEqual(readdirSync(join(home, "bundles")).sort(), [
    digestOf(new Uint8Array([1])),
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

test("a mistyped persisted row is a broken invariant, not a Problem", async (t) => {
  const home = makeTempDir("secant-catalog-");
  // Pre-create a non-STRICT table so a mistyped column survives insertion; the
  // Catalog's own `CREATE TABLE IF NOT EXISTS` then leaves it in place. The row
  // schema (D7) rejects the string in the integer column at read ingress.
  const raw = new Database(join(home, "catalog.db"));
  raw.exec(
    "CREATE TABLE catalog_entries (id TEXT, version TEXT, digest TEXT, " +
      "origin_kind TEXT, origin_location TEXT, installed_at TEXT, " +
      "installation_generation TEXT)",
  );
  raw.exec(
    "INSERT INTO catalog_entries VALUES " +
      "('io.x', '1.0.0', 'abc', 'local-file', '/p', " +
      "'2026-01-01T00:00:00.000Z', 'not-a-number')",
  );
  raw.close();

  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  assert.throws(
    () => catalog.listEntries(),
    /catalog_entries row is malformed/,
  );
});

test("granting trust for an installed digest is readable and idempotent", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  const bytes = new Uint8Array([7, 7, 7]);
  const digest = digestOf(bytes);
  const installed = catalog.installBundle(
    install("io.example.a", "1.0.0", bytes),
  );
  assert.ok(installed.outcome === "installed");
  const generation = installed.entry.installationGeneration;
  assert.equal(catalog.getTrustGrant(digest, generation), undefined);

  const grant = catalog.grantTrust({
    operationId: "op-1",
    digest,
    installationGeneration: generation,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });
  assert.deepEqual(grant, {
    operationId: "op-1",
    grantedAt: "2026-09-12T09:00:00.000Z",
  });
  assert.deepEqual(catalog.getTrustGrant(digest, generation), grant);

  // Re-granting keeps the first receipt and writes nothing new — the same
  // operation id and a different one both replay the original grant.
  assert.deepEqual(
    catalog.grantTrust({
      operationId: "op-1",
      digest,
      installationGeneration: generation,
      grantedAt: new Date("2026-10-10T00:00:00.000Z"),
    }),
    grant,
  );
  assert.deepEqual(
    catalog.grantTrust({
      operationId: "op-2",
      digest,
      installationGeneration: generation,
      grantedAt: new Date("2026-11-11T00:00:00.000Z"),
    }),
    grant,
  );
});

test("a grant persists across reopening the same home", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const bytes = new Uint8Array([4, 2]);
  const digest = digestOf(bytes);
  const first = await openCatalog(home);
  const installed = first.installBundle(
    install("io.example.a", "1.0.0", bytes),
  );
  assert.ok(installed.outcome === "installed");
  const generation = installed.entry.installationGeneration;
  first.grantTrust({
    operationId: "op-1",
    digest,
    installationGeneration: generation,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });
  first.close();

  const second = await openCatalog(home);
  t.after(() => second.close());
  assert.deepEqual(second.getTrustGrant(digest, generation), {
    operationId: "op-1",
    grantedAt: "2026-09-12T09:00:00.000Z",
  });
});

test("granting trust for a digest that is not installed throws", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  assert.throws(
    () =>
      catalog.grantTrust({
        operationId: "op-1",
        digest: "0".repeat(64),
        installationGeneration: 1,
        grantedAt: new Date(),
      }),
    /not installed/,
  );
});

test("an injected failure inside the grant leaves no grant and no receipt", async (t) => {
  const home = makeTempDir("secant-catalog-");
  // Pre-create trust_grants with an always-failing CHECK so the grant's insert
  // faults inside its transaction; the Catalog's own CREATE IF NOT EXISTS then
  // leaves this table in place.
  const raw = new Database(join(home, "catalog.db"));
  raw.exec(
    "CREATE TABLE trust_grants (digest TEXT NOT NULL, " +
      "installation_generation INTEGER NOT NULL, operation_id TEXT NOT NULL, " +
      "granted_at TEXT NOT NULL, PRIMARY KEY (digest, installation_generation), " +
      "CHECK (0)) STRICT",
  );
  raw.close();

  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  const bytes = new Uint8Array([1, 1, 1]);
  const digest = digestOf(bytes);
  const installed = catalog.installBundle(
    install("io.example.a", "1.0.0", bytes),
  );
  assert.ok(installed.outcome === "installed");
  const generation = installed.entry.installationGeneration;

  assert.throws(() =>
    catalog.grantTrust({
      operationId: "op-1",
      digest,
      installationGeneration: generation,
      grantedAt: new Date(),
    }),
  );
  // The transaction rolled back: no grant, no receipt.
  assert.equal(catalog.getTrustGrant(digest, generation), undefined);
});

test("a grant is bound to the installed generation, not the digest alone", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const bytes = new Uint8Array([3, 3]);
  const digest = digestOf(bytes);
  const catalog = await openCatalog(home);
  const installed = catalog.installBundle(
    install("io.example.a", "1.0.0", bytes),
  );
  assert.ok(installed.outcome === "installed");
  const generation = installed.entry.installationGeneration;
  catalog.grantTrust({
    operationId: "op-1",
    digest,
    installationGeneration: generation,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });
  assert.ok(catalog.getTrustGrant(digest, generation));
  catalog.close();

  // Simulate a later reinstall of the same digest at a fresh generation: the
  // grant recorded against the earlier generation no longer counts.
  const raw = new Database(join(home, "catalog.db"));
  raw.exec(
    "UPDATE catalog_entries SET installation_generation = " +
      "installation_generation + 1",
  );
  raw.close();

  const reopened = await openCatalog(home);
  t.after(() => reopened.close());
  assert.equal(reopened.getTrustGrant(digest, generation + 1), undefined);
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

// --- the derived asset tree (#100) ------------------------------------------
//
// The Catalog never parses an archive: composition injects a reader that turns
// exact `.wfb` bytes into the manifest-declared asset files. These tests inject a
// stub keyed by the bytes' first byte, so the tree behaviour is proved without
// real archives.

const treeAssets = [
  { path: "scripts/check.js", data: Buffer.from("console.log('check')") },
  { path: "prompt.md", data: Buffer.from("do the work") },
];
const readStubAssets = (bytes: Uint8Array) =>
  bytes[0] === 0xff ? undefined : treeAssets;

test("an install extracts exactly the declared assets into a digest-named tree beside the bytes", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home, { readAssets: readStubAssets });
  t.after(() => catalog.close());

  const bytes = new Uint8Array([7, 7, 7]);
  const result = catalog.installBundle(install("io.example.a", "1.0.0", bytes));
  assert.equal(result.outcome, "installed");

  const root = catalog.assetRoot(digestOf(bytes));
  assert.equal(root, join(home, "bundles", digestOf(bytes)));
  assert.ok(root !== undefined);
  assert.equal(
    readFileSync(join(root, "scripts", "check.js"), "utf8"),
    "console.log('check')",
  );
  assert.equal(readFileSync(join(root, "prompt.md"), "utf8"), "do the work");
  assert.deepEqual(readdirSync(root).sort(), ["prompt.md", "scripts"]);
  // No staging directory lingers beside the committed tree.
  assert.deepEqual(readdirSync(join(home, "bundles")).sort(), [
    digestOf(bytes),
    `${digestOf(bytes)}.wfb`,
  ]);
  if (process.platform !== "win32") {
    // POSIX: the tree's files are read-only.
    assert.equal(statSync(join(root, "prompt.md")).mode & 0o222, 0);
  }
});

test("a failed install leaves no tree, no bytes, and no Entry", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home, { readAssets: readStubAssets });
  t.after(() => catalog.close());

  assert.throws(() =>
    catalog.installBundle(
      install(
        "io.example.a",
        "1.0.0",
        new Uint8Array([5]),
        undefined,
        "0".repeat(64),
      ),
    ),
  );
  const bundlesDir = join(home, "bundles");
  assert.ok(!existsSync(bundlesDir) || readdirSync(bundlesDir).length === 0);
  assert.equal(catalog.assetRoot("0".repeat(64)), undefined);
  assert.equal(catalog.countInstalledBundles(), 0);
});

test("assetRoot is undefined for a digest that is not installed", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"), {
    readAssets: readStubAssets,
  });
  t.after(() => catalog.close());
  assert.equal(catalog.assetRoot("a".repeat(64)), undefined);
});

test("a missing or corrupt tree is re-extracted from the managed bytes; missing bytes read as not installed", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home, { readAssets: readStubAssets });
  t.after(() => catalog.close());

  const bytes = new Uint8Array([8, 8]);
  catalog.installBundle(install("io.example.a", "1.0.0", bytes));
  const digest = digestOf(bytes);
  const root = catalog.assetRoot(digest);
  assert.ok(root !== undefined);

  // Deleted by hand: re-extracted on the next ask.
  rmSync(root, { recursive: true, force: true });
  assert.equal(catalog.assetRoot(digest), root);
  assert.equal(readFileSync(join(root, "prompt.md"), "utf8"), "do the work");

  // Corrupt (a declared file truncated): re-extracted from the bytes.
  chmodSync(join(root, "prompt.md"), 0o644);
  writeFileSync(join(root, "prompt.md"), "x");
  assert.equal(catalog.assetRoot(digest), root);
  assert.equal(readFileSync(join(root, "prompt.md"), "utf8"), "do the work");

  // The bytes are the authority: without them there is nothing to derive from.
  rmSync(join(home, "bundles", `${digest}.wfb`));
  assert.equal(catalog.assetRoot(digest), undefined);
});

test("a Catalog opened without an asset reader derives an empty tree", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  const bytes = new Uint8Array([3]);
  catalog.installBundle(install("io.example.a", "1.0.0", bytes));
  const root = catalog.assetRoot(digestOf(bytes));
  assert.equal(root, join(home, "bundles", digestOf(bytes)));
  assert.ok(root !== undefined);
  assert.deepEqual(readdirSync(root), []);
});
