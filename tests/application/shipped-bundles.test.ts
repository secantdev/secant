import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApplication } from "../helpers/application.js";
import type { Application } from "../../src/application/application.js";
import { buildBundle } from "../../src/bundle/bundle.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The startup ensure of the Shipped Bundles (#227, ADR 0029 Installation): every
// embedded `.wfb` goes through ordinary ingestion with origin
// `{ kind: "built-in", secantVersion }` and app-release trust. Equal digest is a
// no-op, a different digest is the ordinary collision, and a failure is a notice
// that never blocks another Bundle.

const ID = "dev.secant.shipped-sample";

function shippedFile(version: string, description = "A built-in."): string {
  const folder = makeTempDir("secant-shipped-src-");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: { id: ID, version, name: "Shipped Sample", description },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "echo",
          kind: "command",
          produces: [{ name: "echo-verdict", type: "verdict" }],
          command: { executable: "git", arguments: ["--version"] },
        },
      ],
    }),
  );
  const built = buildBundle(folder);
  assert.ok(built.ok, JSON.stringify(built));
  const file = join(makeTempDir("secant-shipped-dir-"), `${ID}-${version}.wfb`);
  writeFileSync(file, built.built.bytes);
  return file;
}

function home(t: TestContext): Catalog {
  const catalog = openCatalog(makeTempDir("secant-shipped-home-"));
  t.after(() => catalog.close());
  return catalog;
}

function app(catalog: Catalog, engineVersion: string): Application {
  return createApplication({
    catalog,
    launchWorkspacePath: realpathSync.native(makeTempDir("secant-shipped-ws-")),
    engineVersion,
  });
}

function rows(application: Application) {
  const projection = application.projectionPort.openProjection({
    family: "bundle-catalog",
  });
  projection.close();
  const { result } = projection.snapshot;
  assert.ok(result.found, JSON.stringify(result));
  return result.bundles;
}

test("the first startup installs a built-in with its Secant version and app-release trust", (t) => {
  const catalog = home(t);
  const application = app(catalog, "1.0.0");
  assert.deepEqual(
    application.ensureShippedBundles([shippedFile("1.0.0")]),
    [],
  );

  const [row] = rows(application);
  assert.equal(row?.id, ID);
  assert.deepEqual(row?.origin, { kind: "built-in", secantVersion: "1.0.0" });
  assert.equal(row?.shippedWithRunningSecant, true);
  assert.deepEqual(row?.trust, { state: "app-release" });
  const entry = catalog.listEntries()[0]!;
  assert.ok(
    catalog.getTrustGrant(entry.digest, entry.installationGeneration),
    "the app-release trust is a recorded grant, so launch needs no acknowledgement",
  );
});

test("a second startup over the same home is an equal-digest no-op", (t) => {
  const catalog = home(t);
  const file = shippedFile("1.0.0");
  app(catalog, "1.0.0").ensureShippedBundles([file]);
  const [before] = catalog.listEntries();
  const grant = catalog.getTrustGrant(
    before!.digest,
    before!.installationGeneration,
  );

  assert.deepEqual(app(catalog, "1.0.0").ensureShippedBundles([file]), []);
  assert.deepEqual(catalog.listEntries(), [before]);
  assert.deepEqual(
    catalog.getTrustGrant(before!.digest, before!.installationGeneration),
    grant,
  );
});

test("an upgraded Secant installs its built-in beside the older one, which keeps its origin and trust", (t) => {
  const catalog = home(t);
  app(catalog, "1.0.0").ensureShippedBundles([shippedFile("1.0.0")]);
  const upgraded = app(catalog, "1.1.0");
  assert.deepEqual(upgraded.ensureShippedBundles([shippedFile("1.1.0")]), []);

  const listed = rows(upgraded);
  assert.deepEqual(
    listed.map((row) => [
      row.version,
      row.origin,
      row.shippedWithRunningSecant,
      row.trust.state,
    ]),
    [
      [
        "1.1.0",
        { kind: "built-in", secantVersion: "1.1.0" },
        true,
        "app-release",
      ],
      [
        "1.0.0",
        { kind: "built-in", secantVersion: "1.0.0" },
        false,
        "app-release",
      ],
    ],
  );
});

test("importing a built-in's identity follows the ordinary equal-digest and collision contract", (t) => {
  const catalog = home(t);
  const file = shippedFile("1.0.0");
  const application = app(catalog, "1.0.0");
  application.ensureShippedBundles([file]);

  const equal = application.bundleManagement.install(file);
  assert.ok(equal.ok);
  assert.equal(equal.report.installed?.status, "already-installed");

  const different = application.bundleManagement.install(
    shippedFile("1.0.0", "Different bytes, same identity."),
  );
  assert.ok(!different.ok);
  assert.equal(different.problem.code, "bundle-identity-collision");
  assert.match(
    different.problem.explanation,
    /built-in shipped with Secant 1\.0\.0/,
  );
  assert.match(different.problem.remediation, /cannot be removed/);
  assert.equal(catalog.listEntries()[0]?.origin.kind, "built-in");
});

test("a failed ensure is a notice naming cause and remedy, and every other Bundle stays usable", (t) => {
  const catalog = home(t);
  const application = app(catalog, "1.0.0");
  // A user Bundle already holds the built-in's identity with other bytes.
  const imported = application.bundleManagement.install(
    shippedFile("1.0.0", "A user's same-identity Bundle."),
  );
  assert.ok(imported.ok);
  const missing = join(makeTempDir("secant-shipped-gone-"), "gone.wfb");

  const notices = application.ensureShippedBundles([
    shippedFile("1.0.0"),
    missing,
    shippedFile("2.0.0"),
  ]);
  assert.deepEqual(
    notices.map((notice) => [notice.code, notice.details?.cause]),
    [
      ["shipped-bundle-not-installed", "bundle-identity-collision"],
      ["shipped-bundle-not-installed", "bundle-file-unreadable"],
    ],
  );
  for (const notice of notices) assert.ok(notice.remediation.length > 0);

  // The user's Bundle is untouched and the unaffected built-in still installed.
  const listed = rows(application);
  assert.deepEqual(
    listed.map((row) => [row.version, row.origin.kind]),
    [
      ["2.0.0", "built-in"],
      ["1.0.0", "local-file"],
    ],
  );
  const workspace = application.projectionPort.openProjection({
    family: "workspace",
  });
  workspace.close();
  assert.deepEqual(workspace.snapshot.startupNotices, notices);
});

test("equal bytes a user imported first keep their own origin and earn no app-release trust", (t) => {
  const catalog = home(t);
  const file = shippedFile("1.0.0");
  const application = app(catalog, "1.0.0");
  assert.ok(application.bundleManagement.install(file).ok);

  assert.deepEqual(application.ensureShippedBundles([file]), []);
  const [row] = rows(application);
  assert.equal(row?.origin.kind, "local-file");
  assert.deepEqual(row?.trust, { state: "not-yet-trusted" });
  assert.equal(row?.shippedWithRunningSecant, false);
});

test("a built-in left ungranted by a crash after its install earns app-release trust at the next startup", (t) => {
  const catalog = home(t);
  const file = shippedFile("1.0.0");
  const bytes = readFileSync(file);
  catalog.installBundle({
    identity: { id: ID, version: "1.0.0" },
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    origin: { kind: "built-in", secantVersion: "1.0.0" },
    installedAt: new Date(),
  });

  assert.deepEqual(app(catalog, "1.0.0").ensureShippedBundles([file]), []);
  const [entry] = catalog.listEntries();
  assert.equal(
    catalog.getTrustGrant(entry!.digest, entry!.installationGeneration)
      ?.operationId,
    "app-release",
  );
});
