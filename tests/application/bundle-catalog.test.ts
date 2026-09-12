import assert from "node:assert/strict";
import {
  cpSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/application/application.js";
import type {
  BundleCatalogSnapshot,
  InstalledBundleSummary,
  ProjectionPort,
} from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The `bundle-catalog` Projection over real installed bytes (issue #54). It opens
// the family through the Projection Port, exactly as a client does, and asserts
// the list rows, exact focus, sort order, live update on a new install, idempotent
// close, and that no storage path, archive object, or SQLite type ever crosses.

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);

interface Harness {
  readonly port: ProjectionPort;
  readonly home: string;
  readonly catalog: Catalog;
  build(folder: string): void;
  variant(version: string): string;
}

async function harness(
  t: TestContext,
  engineVersion = "9.9.9",
): Promise<Harness> {
  const home = makeTempDir("secant-catalog-home-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  const launchWorkspacePath = realpathSync.native(
    makeTempDir("secant-cat-ws-"),
  );
  const { projectionPort, bundleManagement } = createApplication({
    catalog,
    launchWorkspacePath,
    engineVersion,
    hostPlatform: "linux",
  });
  return {
    port: projectionPort,
    home,
    catalog,
    build(folder) {
      const result = bundleManagement.build(folder, { noInstall: false });
      assert.ok(result.ok, JSON.stringify(result));
    },
    // A copy of the Proof Bundle whose manifest version is overridden, so a
    // second identity installs beside the first.
    variant(version) {
      const folder = makeTempDir("secant-cat-variant-");
      cpSync(proofBundle, folder, { recursive: true });
      const manifestPath = join(folder, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.bundle.version = version;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return folder;
    },
  };
}

function list(port: ProjectionPort): BundleCatalogSnapshot {
  const opened = port.openProjection({ family: "bundle-catalog" });
  try {
    return opened.snapshot;
  } finally {
    opened.close();
  }
}

/** The list rows, asserting the list resolved (found). */
function listRows(port: ProjectionPort): readonly InstalledBundleSummary[] {
  const snapshot = list(port);
  assert.ok(snapshot.result.found, JSON.stringify(snapshot.result));
  return snapshot.result.bundles;
}

test("the list shows one row with identity, digest, platforms, engine and trust", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);

  const snapshot = list(h.port);
  assert.equal(snapshot.family, "bundle-catalog");
  assert.equal(snapshot.view, "list");
  assert.ok(snapshot.result.found, JSON.stringify(snapshot.result));
  assert.equal(snapshot.result.bundles.length, 1);
  const [row] = snapshot.result.bundles;
  assert.equal(row.id, "dev.secant.test-repair");
  assert.equal(row.version, "1.0.0");
  assert.match(row.digest, /^[0-9a-f]{64}$/);
  assert.equal(row.name, "Test Repair Workflow");
  assert.equal(row.stability, "stable");
  assert.deepEqual([...row.platforms], ["windows", "macos", "linux"]);
  assert.equal(row.engine.range, ">=0.1.0");
  assert.equal(row.engine.satisfied, true);
  assert.equal(row.engine.note, undefined);
  assert.deepEqual(row.trust, { state: "not-yet-trusted" });
  assert.equal(row.origin.kind, "local-build");
});

test("a recorded Trust grant makes the list row and focus report trusted", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);
  const [entry] = h.catalog.listEntries();
  h.catalog.grantTrust({
    operationId: "op-trust-1",
    digest: entry.digest,
    installationGeneration: entry.installationGeneration,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });

  const [row] = listRows(h.port);
  assert.deepEqual(row.trust, {
    state: "trusted",
    operationId: "op-trust-1",
    grantedAt: "2026-09-12T09:00:00.000Z",
  });

  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.ok(snapshot.result.found);
  if (snapshot.result.found) {
    assert.deepEqual(snapshot.result.bundle.trust, {
      state: "trusted",
      operationId: "op-trust-1",
      grantedAt: "2026-09-12T09:00:00.000Z",
    });
  }
});

test("a grant does not make a different installed digest trusted", async (t) => {
  const h = await harness(t);
  h.build(h.variant("1.0.0"));
  h.build(h.variant("2.0.0"));
  const entries = h.catalog.listEntries();
  const v1 = entries.find((entry) => entry.version === "1.0.0");
  assert.ok(v1);
  h.catalog.grantTrust({
    operationId: "op-trust-1",
    digest: v1.digest,
    installationGeneration: v1.installationGeneration,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });

  const rows = listRows(h.port);
  const byVersion = new Map(rows.map((row) => [row.version, row.trust.state]));
  assert.equal(byVersion.get("1.0.0"), "trusted");
  assert.equal(byVersion.get("2.0.0"), "not-yet-trusted");
});

test("two installed versions sort by name then version descending", async (t) => {
  const h = await harness(t);
  h.build(h.variant("1.0.0"));
  h.build(h.variant("2.0.0"));

  const rows = listRows(h.port);
  assert.deepEqual(
    rows.map((row) => row.version),
    ["2.0.0", "1.0.0"],
  );
  assert.equal(rows[0].name, rows[1].name);
});

test("a Bundle whose engine excludes the running Secant shows the needs-Secant note", async (t) => {
  const h = await harness(t, "0.0.5");
  h.build(proofBundle);

  const [row] = listRows(h.port);
  assert.equal(row.engine.satisfied, false);
  assert.equal(row.engine.note, "needs Secant ≥ 0.1");
});

test("a prerelease Secant build above the floor still satisfies the engine range", async (t) => {
  const h = await harness(t, "0.2.0-rc.1");
  h.build(proofBundle);

  const [row] = listRows(h.port);
  assert.equal(row.engine.satisfied, true);
  assert.equal(row.engine.note, undefined);
});

test("the exact focus carries every fact including the Execution summary and zero error findings", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);

  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.equal(snapshot.view, "focus");
  assert.ok(snapshot.result.found, JSON.stringify(snapshot.result));
  if (!snapshot.result.found) return;
  const bundle = snapshot.result.bundle;

  // Focus adds launch inputs, routing (with the Repeat group and its checkpoint),
  // Workspace prerequisites, produced artifacts, and the Composition findings.
  assert.deepEqual(bundle.launchInputs, [
    {
      name: "failing-test",
      type: "file",
      description: "Path to the failing test to repair.",
    },
  ]);
  const repeat = bundle.routing.find((node) => node.node === "repeat");
  assert.ok(repeat && repeat.node === "repeat");
  assert.equal(repeat.until, "test-verdict");
  assert.equal(repeat.reviewCheckpoint.interval, 5);
  assert.deepEqual(bundle.workspacePrerequisites, ["git-worktree-root"]);
  assert.ok(
    bundle.producedArtifacts.some(
      (artifact) => artifact.name === "commit-verdict",
    ),
  );
  assert.deepEqual(bundle.compositionFindings, []);

  // The generated Execution summary for the selected (host) platform.
  const summary = bundle.executionSummary;
  assert.equal(summary.platform, "linux");
  assert.equal(summary.digest, bundle.digest);
  assert.deepEqual(summary.stepKindCounts, {
    command: 3,
    agent: 1,
    "human-gate": 1,
  });
  const baseline = summary.commands.find((c) => c.stepId === "baseline-test");
  assert.ok(baseline);
  assert.equal(baseline.executable, "bash");
  assert.deepEqual(baseline.scripts, ["scripts/run-test.sh"]);
  assert.equal(baseline.workingDirectory, ".");
  assert.match(summary.warning, /current user's authority/);
});

test("a per-platform override resolves the command for the chosen platform", async (t) => {
  const home = makeTempDir("secant-cat-win-home-");
  const catalog = await openCatalog(home);
  t.after(() => catalog.close());
  const { projectionPort, bundleManagement } = createApplication({
    catalog,
    launchWorkspacePath: realpathSync.native(makeTempDir("secant-cat-win-ws-")),
    engineVersion: "9.9.9",
    hostPlatform: "windows",
  });
  assert.ok(bundleManagement.build(proofBundle, { noInstall: false }).ok);

  const opened = projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.ok(snapshot.result.found);
  if (!snapshot.result.found) return;
  const baseline = snapshot.result.bundle.executionSummary.commands.find(
    (c) => c.stepId === "baseline-test",
  );
  assert.ok(baseline);
  assert.equal(baseline.executable, "pwsh");
  assert.deepEqual(baseline.scripts, ["scripts/run-test.ps1"]);
});

test("version selection: exact, highest-stable default, and prerelease must be named", async (t) => {
  const h = await harness(t);
  h.build(h.variant("1.0.0"));
  h.build(h.variant("2.0.0"));
  h.build(h.variant("3.0.0-rc.1"));

  const exact = (version?: string) => {
    const opened = h.port.openProjection({
      family: "bundle-catalog",
      focus: { id: "dev.secant.test-repair", ...(version ? { version } : {}) },
    });
    try {
      return opened.snapshot;
    } finally {
      opened.close();
    }
  };

  // An omitted version selects the highest stable (2.0.0), never the prerelease.
  const highestStable = exact();
  assert.ok(highestStable.result.found);
  if (highestStable.result.found) {
    assert.equal(highestStable.result.bundle.version, "2.0.0");
  }

  // An exact version selects it, prerelease included.
  const prerelease = exact("3.0.0-rc.1");
  assert.ok(prerelease.result.found);
  if (prerelease.result.found) {
    assert.equal(prerelease.result.bundle.stability, "prerelease");
  }

  // An unknown version is a Problem.
  const unknownVersion = exact("9.9.9");
  assert.equal(unknownVersion.result.found, false);
  if (!unknownVersion.result.found) {
    assert.equal(
      unknownVersion.result.problem.code,
      "bundle-version-not-installed",
    );
  }
});

test("inspecting an unknown id is a Problem", async (t) => {
  const h = await harness(t);
  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "io.example.absent" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.equal(snapshot.result.found, false);
  if (!snapshot.result.found) {
    assert.equal(snapshot.result.problem.code, "bundle-not-installed");
  }
});

test("an omitted version with only prereleases installed is a Problem", async (t) => {
  const h = await harness(t);
  h.build(h.variant("1.0.0-rc.1"));

  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.equal(snapshot.result.found, false);
  if (!snapshot.result.found) {
    assert.equal(snapshot.result.problem.code, "no-stable-version-installed");
  }
});

test("an open list projection updates when a new Bundle installs", async (t) => {
  const h = await harness(t);
  const opened = h.port.openProjection({ family: "bundle-catalog" });
  t.after(() => opened.close());
  const initial = opened.snapshot;
  assert.ok(initial.result.found);
  assert.equal(initial.result.bundles.length, 0);
  const updates = opened.updates[Symbol.asyncIterator]();

  h.build(proofBundle);

  const update = await updates.next();
  assert.equal(update.done, false);
  assert.ok(update.value && update.value.kind === "durable");
  const snapshot = update.value.snapshot;
  assert.equal(snapshot.family, "bundle-catalog");
  assert.ok(snapshot.result.found);
  assert.equal(snapshot.result.bundles.length, 1);
  assert.equal(snapshot.result.bundles[0].id, "dev.secant.test-repair");
});

test("closing a bundle-catalog projection twice is a no-op", async (t) => {
  const h = await harness(t);
  const opened = h.port.openProjection({ family: "bundle-catalog" });
  opened.close();
  opened.close();
});

test("focus on a Bundle whose stored bytes are gone is a Problem, not a crash", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);
  const [digest] = h.catalog.listEntries().map((entry) => entry.digest);
  rmSync(join(h.home, "bundles", `${digest}.wfb`));

  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  t.after(() => opened.close());
  const snapshot = opened.snapshot;
  assert.equal(snapshot.result.found, false);
  if (!snapshot.result.found) {
    assert.equal(snapshot.result.problem.code, "bundle-bytes-missing");
  }
});

test("listing a Bundle whose stored bytes are gone is a Problem, not a crash", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);
  const [digest] = h.catalog.listEntries().map((entry) => entry.digest);
  rmSync(join(h.home, "bundles", `${digest}.wfb`));

  const snapshot = list(h.port);
  assert.equal(snapshot.result.found, false);
  if (!snapshot.result.found) {
    assert.equal(snapshot.result.problem.code, "bundle-bytes-missing");
  }
});

test("no storage path, archive object, or SQLite type appears in any snapshot", async (t) => {
  const h = await harness(t);
  h.build(proofBundle);

  const listSerialized = JSON.stringify(list(h.port));
  const opened = h.port.openProjection({
    family: "bundle-catalog",
    focus: { id: "dev.secant.test-repair" },
  });
  const focusSerialized = JSON.stringify(opened.snapshot);
  opened.close();

  for (const serialized of [listSerialized, focusSerialized]) {
    // The managed store lives under the Secant home; its path must never cross.
    assert.equal(serialized.includes(h.home), false, serialized);
    assert.equal(serialized.includes("catalog.db"), false);
    assert.equal(serialized.includes(".wfb"), false);
  }
});
